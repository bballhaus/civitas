"""
Test script that scrapes one event and saves it to CSV
"""

import requests
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
import csv
import time
import os

import os
download_dir = os.path.abspath('downloads')
os.makedirs(download_dir, exist_ok=True)


TEST_URL = 'https://caleprocure.ca.gov/event/3540/35409TSC01'
OUTPUT_FILE = 'test_event.csv'


def test_selenium_scrape():
    print(f"Testing Selenium scrape on: {TEST_URL}")
    print("=" * 80)

    options = webdriver.ChromeOptions()
    options.add_experimental_option("prefs", {
        "download.default_directory": download_dir,
        "download.prompt_for_download": False,
        "download.directory_upgrade": True,
        "safebrowsing.enabled": True
    })
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')


    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=options)
    wait = WebDriverWait(driver, 15)


    
    
    try:
        # Load the page
        print("\n1. Loading page...")
        driver.get(TEST_URL)
        
        # Wait for JavaScript to load data
        print("2. Waiting for JavaScript to populate data...")
        wait.until(
            EC.presence_of_element_located((By.CSS_SELECTOR, '[data-if-label="eventName"]'))
        )
        
        # Give extra time for all data to load
        time.sleep(3)
        
        print("\n3. Extracting data...")
        print("-" * 80)
        
        # Create dictionary to store event data
        event_data = {
            'event_url': TEST_URL,
            'event_id': '',
            'title': '',
            'description': '',
            'contact_name': '',
            'contact_email': '',
            'contact_phone': '',
            'department': '',
            'start_date': '',
            'end_date': '',
            'format': ''
        }
        
        # Extract event ID from URL
        parts = TEST_URL.split('/')
        if len(parts) >= 4:
            event_data['event_id'] = f"{parts[-2]}/{parts[-1]}"
        
        # Extract title
        try:
            title_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventName"]')
            title = title_elem.text.strip()
            if title and title != '[Event Title]':
                event_data['title'] = title
                print(f"✓ Title: {title}")
        except:
            print("✗ Title: NOT FOUND")
        
        # Extract description
        try:
            desc_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="descriptiondetails"]')
            desc = desc_elem.text.strip()
            if desc and desc != '[Detail Description]':
                event_data['description'] = desc
                print(f"✓ Description: {desc[:100]}...")
        except:
            print("✗ Description: NOT FOUND")
        
        # Extract contact name
        try:
            contact_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="contactName"]')
            contact = contact_elem.text.strip()
            if contact and contact != '[Contact Name]':
                event_data['contact_name'] = contact
                print(f"✓ Contact Name: {contact}")
        except:
            print("✗ Contact Name: NOT FOUND")
        
        # Extract email
        try:
            email_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="emailAnchor"]')
            email = email_elem.text.strip()
            if email and email != '[EmailAddress]':
                event_data['contact_email'] = email
                print(f"✓ Email: {email}")
        except:
            try:
                email_elem = driver.find_element(By.ID, 'RESP_INQ_DL0_WK_EMAILID')
                email = email_elem.text.strip()
                if email:
                    event_data['contact_email'] = email
                    print(f"✓ Email (alternate): {email}")
            except:
                print("✗ Email: NOT FOUND")
        
        # Extract phone
        try:
            phone_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="phoneText"]')
            phone = phone_elem.text.strip()
            if phone and phone != '[Phone Number]':
                event_data['contact_phone'] = phone
                print(f"✓ Phone: {phone}")
        except:
            print("✗ Phone: NOT FOUND")
        
        # Extract department
        try:
            dept_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="dept"]')
            dept = dept_elem.text.strip()
            if dept:
                event_data['department'] = dept
                print(f"✓ Department: {dept}")
        except:
            print("✗ Department: NOT FOUND")
        
        # Extract start date
        try:
            start_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventStartDate"]')
            start_date = start_elem.text.strip()
            if start_date:
                event_data['start_date'] = start_date
                print(f"✓ Start Date: {start_date}")
        except:
            print("✗ Start Date: NOT FOUND")
        
        # Extract end date
        try:
            end_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="eventEndDate"]')
            end_date = end_elem.text.strip()
            if end_date:
                event_data['end_date'] = end_date
                print(f"✓ End Date: {end_date}")
        except:
            print("✗ End Date: NOT FOUND")
        
        # Extract format
        try:
            format1_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="format1"]')
            format2_elem = driver.find_element(By.CSS_SELECTOR, '[data-if-label="format2"]')
            format1 = format1_elem.text.strip()
            format2 = format2_elem.text.strip()
            if format1 or format2:
                event_data['format'] = f"{format1} / {format2}".strip(' /')
                print(f"✓ Format: {event_data['format']}")
        except:
            print("✗ Format: NOT FOUND")
        
        print("-" * 80)
        
        # Write to CSV
        print(f"\n4. Writing data to {OUTPUT_FILE}...")
        
        with open(OUTPUT_FILE, mode='w', newline='', encoding='utf-8') as csv_file:
            fieldnames = [
                'event_id', 'event_url', 'title', 'description',
                'department', 'format', 'start_date', 'end_date',
                'contact_name', 'contact_email', 'contact_phone'
            ]
            
            writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerow(event_data)
        
        print(f"✓ Successfully saved to {OUTPUT_FILE}")
        print("\n" + "=" * 80)
        print("Test complete!")
        print(f"Check {OUTPUT_FILE} for the scraped data.")

        # Set Chrome to download to a specific folder (add to options setup at top)
        download_attachments(driver, wait, download_dir='downloads')

        print("\nPress Enter to close browser...")
        input()
        
    except Exception as e:
        print(f"\n✗ Error: {e}")
        import traceback
        traceback.print_exc()
    
    finally:
        driver.quit()
        print("\nBrowser closed.")

def download_attachments(driver, wait, download_dir='downloads'):
    """
    Clicks 'View Event Package', waits for attachments to load,
    then clicks all download buttons found.
    """
    os.makedirs(download_dir, exist_ok=True)
    
    print("\n5. Looking for 'View Event Package' button...")
    
    # ── Step 1: Click "View Event Package" ──────────────────────────────────
    try:
        view_pkg_btn = wait.until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, '[data-if-label="viewPackage"]'))
        )
        print("✓ Found 'View Event Package' button")
        view_pkg_btn.click()
        print("✓ Clicked 'View Event Package'")
    except Exception as e:
        print(f"✗ Could not find/click 'View Event Package': {e}")
        return

    # ── Step 2: Wait for attachments table to populate ──────────────────────
    print("\n6. Waiting for attachments to load...")
    time.sleep(4)  # Match your existing wait pattern

    try:
        wait.until(
            EC.presence_of_element_located(
                (By.CSS_SELECTOR, '[data-if-label^="ViewAttachmentsTableRow"]')
            )
        )
        print("✓ Attachments table loaded")
    except Exception as e:
        print(f"✗ Attachments table did not load: {e}")
        return

    # ── Step 3: Find all download buttons ───────────────────────────────────
    print("\n7. Finding download buttons...")
    
    try:
        # Targets buttons with the fa-download icon inside them
        download_buttons = driver.find_elements(
            By.CSS_SELECTOR,
            '[data-if-label^="ViewAttachmentsView"] .fa-download'
        )
        
        # Fall back: target the button itself if icon search returns nothing
        if not download_buttons:
            download_buttons = driver.find_elements(
                By.CSS_SELECTOR,
                'button[data-if-label^="ViewAttachmentsView"]'
            )

        total = len(download_buttons)
        print(f"✓ Found {total} download button(s)")

        print(f"✓ Found {len(download_buttons)} download button(s)")
        
        for i in range(total):
            try:
                download_buttons = driver.find_elements(
                    By.CSS_SELECTOR, 'button[data-if-label^="ViewAttachmentsView"]'
                )
                btn = download_buttons[i]
                
                # Scroll into view and click the attachment row button
                driver.execute_script("arguments[0].scrollIntoView(true);", btn)
                time.sleep(0.5)
                btn.click()
                print(f"  ✓ Clicked download button #{i + 1}")

                # ── Wait for modal to appear ──────────────────────────────
                print(f"  Waiting for download modal...")
                wait.until(
                    EC.visibility_of_element_located((By.ID, 'attachmentBox'))
                )
                time.sleep(3)  # Extra wait for modal to fully populate

                # ── Click the actual Download Attachment link ─────────────
                download_link = wait.until(
                    EC.element_to_be_clickable((By.ID, 'downloadButton'))
                )
                pdf_url = download_link.get_attribute('href')
                print(f"  ✓ PDF URL: {pdf_url}")
                # Get cookies from selenium session to authenticate the request
                cookies = {c['name']: c['value'] for c in driver.get_cookies()}

                # Derive filename from URL or fallback to index
                filename = pdf_url.split('/')[-1].split('?')[0] or f'attachment_{i+1}.pdf'
                filepath = os.path.join(download_dir, filename)

                response = requests.get(pdf_url, cookies=cookies, stream=True)
                with open(filepath, 'wb') as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        f.write(chunk)

                print(f"  ✓ Saved to: {filepath}")

                time.sleep(3)  # Let download start

                # ── Close the modal ───────────────────────────────────────
                close_btn = driver.find_element(
                    By.CSS_SELECTOR, '#attachmentWrapperModal .btn-outline-primary'
                )
                close_btn.click()
                print(f"  ✓ Closed modal")

                time.sleep(3)  # Brief pause before next attachment

            except Exception as e:
                print(f"  ✗ Error on download button #{i + 1}: {e}")
                # Try to close modal if it's stuck open
                try:
                    driver.find_element(
                        By.CSS_SELECTOR, '#attachmentWrapperModal .btn-outline-primary'
                    ).click()
                except:
                    pass

    except Exception as e:
        print(f"✗ Error finding download buttons: {e}")


if __name__ == '__main__':
    test_selenium_scrape()
    # After all your existing extractions...
    print("-" * 80)